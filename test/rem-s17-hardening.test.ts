import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { captureFileSource, type SourceCaptureSuccess } from "../src/sourceCapture/index.js";
import { parseInitJson, readGeneratedFile, runCliBuffered, withTempWorkspace } from "./helpers/init.js";

type LintIssue = {
  rule_id: string;
  severity: "error" | "warning";
  path: string;
  line?: number;
  message: string;
  fix_hint: string;
  fixable: boolean;
};

type LintFailureEnvelope = {
  ok: false;
  command: "lint";
  repo: string;
  error: {
    code: "lint_failed";
    message: string;
    hint: string;
  };
  issues: LintIssue[];
};

type LintSuccessEnvelope = {
  ok: true;
  command: "lint";
  repo: string;
  data: {
    issues: LintIssue[];
    fixed_paths: string[];
  };
  warnings: string[];
};

async function initializeWiki(targetDir: string): Promise<void> {
  const result = await runCliBuffered(["init", targetDir, "--no-git", "--json"]);

  expect(result.exitCode).toBe(0);
  parseInitJson(result.stdout);
}

async function captureSource(
  wikiDir: string,
  workspaceDir: string,
  title = "Research Note",
  content = "# Research Note\n\nRaw observation.\n",
): Promise<SourceCaptureSuccess["source"]> {
  const sourcePath = resolve(workspaceDir, `${title}.md`);
  await writeFile(sourcePath, content, "utf8");

  const capture = await captureFileSource({
    repoRoot: wikiDir,
    sourcePath,
    title,
    now: new Date("2026-06-17T11:28:42.778Z"),
    command: `llm-wiki add ${title}.md --title ${title}`,
  });

  expect(capture.ok).toBe(true);
  if (!capture.ok) {
    throw new Error(capture.error.message);
  }

  return capture.value.source;
}

async function writeCuratedPage(
  wikiDir: string,
  path: string,
  frontmatter: Record<string, unknown>,
  body: string,
): Promise<void> {
  const absolutePath = resolve(wikiDir, path);
  await mkdir(resolve(absolutePath, ".."), { recursive: true });
  await writeFile(absolutePath, `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${body}`, "utf8");
}

function parseLintFailure(stdout: string[]): LintFailureEnvelope {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0]) as LintFailureEnvelope;
}

function parseLintSuccess(stdout: string[]): LintSuccessEnvelope {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0]) as LintSuccessEnvelope;
}

function issueByRuleAndPath(issues: LintIssue[], ruleId: string, path: string): LintIssue {
  const issue = issues.find((candidate) => candidate.rule_id === ruleId && candidate.path === path);
  expect(issue, `expected lint issue ${ruleId} at ${path}`).toBeDefined();

  if (issue === undefined) {
    throw new Error(`expected lint issue ${ruleId} at ${path}`);
  }

  return issue;
}

function publicProfileYaml(include: string[]): string {
  return `name: public
mode: deploy
include:
${include.map((pattern) => `  - ${pattern}`).join("\n")}
exclude: []
visibility:
  include_private: false
  required_value: public
safety:
  fail_on_private_pages: true
  fail_on_private_links: true
  fail_on_raw_links: true
  fail_on_public_graph_private_nodes: true
  fail_on_public_search_private_text: true
`;
}

describe("REM-S17 public leak hardening", () => {
  it("documents the strict public threat model and scanner contract", async () => {
    // Arrange
    const threatTargets = [
      "raw originals",
      "raw source cards",
      "raw assets",
      "private curated pages",
      "private source summaries",
      "queue files",
      "runtime logs",
      "generated cache data",
      "local filesystem paths",
      "links that can expose those targets",
    ];
    const scannerForms = [
      "inline Markdown links",
      "reference links",
      "collapsed and shortcut reference links",
      "image links",
      "Obsidian wikilinks",
      "HTML href, src, srcset, poster, data, and data-* resource attributes",
      "file: URLs",
      "Windows drive-letter paths",
      "percent-encoded and entity-encoded destinations",
    ];

    // Act
    const readme = await readFile(resolve(process.cwd(), "README.md"), "utf8");

    // Assert
    expect(readme).toContain("## Public Strict Threat Model");
    for (const target of threatTargets) {
      expect(readme, target).toContain(target);
    }
    for (const scannerForm of scannerForms) {
      expect(readme, scannerForm).toContain(scannerForm);
    }
  });

  it("fails public strict lint for collapsed reference links whose labels contain balanced brackets", async () => {
    await withTempWorkspace("llm-wiki-rem-s17-balanced-collapsed-ref-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeFile(resolve(wikiDir, ".llm-wiki/profiles/public.yml"), publicProfileYaml(["curated/topics/public-topic.md"]), "utf8");
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        `# Public Topic

Collapsed reference leak: [raw [PDF]][].

[raw [PDF]]: ../../${source.original_path}
`,
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(issueByRuleAndPath(payload.issues, "public_raw_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        message: expect.stringContaining("[raw [PDF]][]"),
        fixable: false,
      });
    });
  });

  it("resolves wikilinks through frontmatter aliases before public leak checks", async () => {
    await withTempWorkspace("llm-wiki-rem-s17-alias-leak-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeFile(resolve(wikiDir, ".llm-wiki/profiles/public.yml"), publicProfileYaml(["curated/topics/public-topic.md"]), "utf8");
      await writeCuratedPage(
        wikiDir,
        "curated/private/secret.md",
        {
          type: "page",
          title: "Secret Page",
          aliases: ["Classified Alias"],
          visibility: "private",
          source_ids: [source.source_id],
        },
        "# Secret Page\n\nPrivate detail.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        "# Public Topic\n\nLeaks through [[Classified Alias]].\n",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(payload.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "wikilink_broken",
          path: "curated/topics/public-topic.md",
        }),
      );
      expect(issueByRuleAndPath(payload.issues, "public_private_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        message: expect.stringContaining("[[Classified Alias]]"),
        fixable: false,
      });
      expect(issueByRuleAndPath(payload.issues, "public_graph_private_node_leak", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        fixable: false,
      });
    });
  });

  it("prefers concrete wikilink basenames before private aliases", async () => {
    await withTempWorkspace("llm-wiki-rem-s17-basename-before-alias-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        publicProfileYaml(["curated/topics/linker.md", "curated/entities/foo.md"]),
        "utf8",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/private/secret.md",
        {
          type: "page",
          title: "Secret Page",
          aliases: ["foo"],
          visibility: "private",
          source_ids: [source.source_id],
        },
        "# Secret Page\n\nPrivate detail.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/entities/foo.md",
        { type: "entity", title: "Public Foo", visibility: "public", source_ids: [source.source_id] },
        "# Public Foo\n\nPublic detail.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/linker.md",
        { type: "topic", title: "Linker", visibility: "public", source_ids: [source.source_id] },
        "# Linker\n\nLinks to [[foo]].\n",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintSuccess(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "public_private_link",
          path: "curated/topics/linker.md",
        }),
      );
      expect(payload.data.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "public_graph_private_node_leak",
          path: "curated/topics/linker.md",
        }),
      );
      expect(payload.data.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "wikilink_broken",
          path: "curated/topics/linker.md",
        }),
      );
    });
  });

  it("fails closed when public profiles select skipped generated Explorer output", async () => {
    await withTempWorkspace("llm-wiki-rem-s17-generated-output-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await mkdir(resolve(wikiDir, "quartz/public"), { recursive: true });
      await writeFile(resolve(wikiDir, "quartz/public/search.json"), "{\"private\":\"cached text\"}\n", "utf8");
      await writeFile(resolve(wikiDir, ".llm-wiki/profiles/public.yml"), publicProfileYaml(["quartz/public/**"]), "utf8");

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(issueByRuleAndPath(payload.issues, "public_skipped_private_path_selected", "quartz/public")).toMatchObject({
        severity: "error",
        message: expect.stringContaining("generated/private data"),
        fixable: false,
      });
    });
  });

  it("fails closed when Quartz asset globs select skipped public output", async () => {
    await withTempWorkspace("llm-wiki-rem-s17-generated-asset-glob-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await mkdir(resolve(wikiDir, "quartz/public/assets"), { recursive: true });
      await writeFile(resolve(wikiDir, "quartz/public/assets/app.js"), "console.log('private cached text');\n", "utf8");
      await writeFile(resolve(wikiDir, ".llm-wiki/profiles/public.yml"), publicProfileYaml(["quartz/**/*.js"]), "utf8");

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(issueByRuleAndPath(payload.issues, "public_skipped_private_path_selected", "quartz/public")).toMatchObject({
        severity: "error",
        message: expect.stringContaining("generated/private data"),
        fixable: false,
      });
    });
  });

  it("fails closed when shallow excludes leave deeper skipped public output selected", async () => {
    await withTempWorkspace("llm-wiki-rem-s17-generated-shallow-exclude-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await mkdir(resolve(wikiDir, "quartz/public/assets"), { recursive: true });
      await writeFile(resolve(wikiDir, "quartz/public/assets/app.js"), "console.log('private cached text');\n", "utf8");
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        `name: public
mode: deploy
include:
  - "**/*.js"
exclude:
  - .llm-wiki/cache/**
  - quartz/content/**
  - quartz/public/*.js
visibility:
  include_private: false
  required_value: public
safety:
  fail_on_private_pages: true
  fail_on_private_links: true
  fail_on_raw_links: true
  fail_on_public_graph_private_nodes: true
  fail_on_public_search_private_text: true
`,
        "utf8",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(issueByRuleAndPath(payload.issues, "public_skipped_private_path_selected", "quartz/public")).toMatchObject({
        severity: "error",
        message: expect.stringContaining("generated/private data"),
        fixable: false,
      });
    });
  });

  it("fails closed when shallow asset excludes leave deeper skipped public output selected", async () => {
    await withTempWorkspace("llm-wiki-rem-s17-generated-shallow-asset-exclude-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await mkdir(resolve(wikiDir, "quartz/public/assets/nested"), { recursive: true });
      await writeFile(resolve(wikiDir, "quartz/public/assets/nested/app.js"), "console.log('private cached text');\n", "utf8");
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        `name: public
mode: deploy
include:
  - quartz/public/assets/**
exclude:
  - quartz/public/assets/*
visibility:
  include_private: false
  required_value: public
safety:
  fail_on_private_pages: true
  fail_on_private_links: true
  fail_on_raw_links: true
  fail_on_public_graph_private_nodes: true
  fail_on_public_search_private_text: true
`,
        "utf8",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(issueByRuleAndPath(payload.issues, "public_skipped_private_path_selected", "quartz/public")).toMatchObject({
        severity: "error",
        message: expect.stringContaining("generated/private data"),
        fixable: false,
      });
    });
  });

  it("fails closed when trailing asset globstars select skipped public output", async () => {
    await withTempWorkspace("llm-wiki-rem-s17-generated-trailing-asset-glob-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await mkdir(resolve(wikiDir, "quartz/public/assets"), { recursive: true });
      await writeFile(resolve(wikiDir, "quartz/public/assets/app.js"), "console.log('private cached text');\n", "utf8");

      for (const includePattern of ["**/assets/**", "quartz/**/assets/**"]) {
        await writeFile(resolve(wikiDir, ".llm-wiki/profiles/public.yml"), publicProfileYaml([JSON.stringify(includePattern)]), "utf8");

        // Act
        const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
        const payload = parseLintFailure(result.stdout);

        // Assert
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toEqual([]);
        expect(issueByRuleAndPath(payload.issues, "public_skipped_private_path_selected", "quartz/public")).toMatchObject({
          severity: "error",
          message: expect.stringContaining("generated/private data"),
          fixable: false,
        });
      }
    });
  });

  it("fails closed when public profiles select skipped build output", async () => {
    await withTempWorkspace("llm-wiki-rem-s17-dist-output-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await mkdir(resolve(wikiDir, "dist/assets"), { recursive: true });
      await writeFile(resolve(wikiDir, "dist/assets/private.js"), "console.log('private generated text');\n", "utf8");
      await writeFile(resolve(wikiDir, ".llm-wiki/profiles/public.yml"), publicProfileYaml(["dist/**"]), "utf8");

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(issueByRuleAndPath(payload.issues, "public_skipped_private_path_selected", "dist")).toMatchObject({
        severity: "error",
        message: expect.stringContaining("generated/private data"),
        fixable: false,
      });
    });
  });

  it("fails closed when public profiles select generated Quartz content materialization", async () => {
    await withTempWorkspace("llm-wiki-rem-s17-generated-content-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await mkdir(resolve(wikiDir, "quartz/content"), { recursive: true });
      await writeFile(
        resolve(wikiDir, "quartz/content/index.md"),
        `---
type: index
title: Generated Explorer Index
visibility: public
source_ids: []
---

# Generated Explorer Index

Cached generated content can contain [[Private Page]] and raw/inputs/source/original.md.
`,
        "utf8",
      );
      await writeFile(resolve(wikiDir, ".llm-wiki/profiles/public.yml"), publicProfileYaml(["quartz/content/**"]), "utf8");

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(issueByRuleAndPath(payload.issues, "public_skipped_private_path_selected", "quartz/content")).toMatchObject({
        severity: "error",
        message: expect.stringContaining("generated/private data"),
        fixable: false,
      });
    });
  });

  it("fails closed when public pages link to skipped generated Explorer output", async () => {
    await withTempWorkspace("llm-wiki-rem-s17-generated-output-link-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await mkdir(resolve(wikiDir, "quartz/public"), { recursive: true });
      await writeFile(resolve(wikiDir, "quartz/public/search.json"), "{\"private\":\"cached text\"}\n", "utf8");
      await writeFile(resolve(wikiDir, ".llm-wiki/profiles/public.yml"), publicProfileYaml(["curated/topics/public-topic.md"]), "utf8");
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [] },
        "# Public Topic\n\nGenerated output link: [search](../../quartz/public/search.json?cache=1#results).\n",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(issueByRuleAndPath(payload.issues, "public_skipped_private_path_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        message: expect.stringContaining("quartz/public"),
        fixable: false,
      });
      expect(payload.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "public_skipped_private_path_selected",
          path: "quartz/public",
        }),
      );
    });
  });

  it("fails closed when public profiles select runtime logs even if frontmatter is public", async () => {
    await withTempWorkspace("llm-wiki-rem-s17-public-runtime-log-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await writeFile(resolve(wikiDir, ".llm-wiki/profiles/public.yml"), publicProfileYaml(["curated/log.md"]), "utf8");
      const logBefore = await readGeneratedFile(wikiDir, "curated/log.md");
      await writeFile(resolve(wikiDir, "curated/log.md"), logBefore.replace(/^visibility: private$/m, "visibility: public"), "utf8");

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(issueByRuleAndPath(payload.issues, "public_runtime_log_selected", "curated/log.md")).toMatchObject({
        severity: "error",
        message: expect.stringContaining("runtime log"),
        fixable: false,
      });
      expect(payload.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "public_private_page_selected",
          path: "curated/log.md",
        }),
      );
    });
  });

  it("fails closed when public pages link to runtime logs even if the log is not selected", async () => {
    await withTempWorkspace("llm-wiki-rem-s17-public-runtime-log-link-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await writeFile(resolve(wikiDir, ".llm-wiki/profiles/public.yml"), publicProfileYaml(["curated/topics/public-topic.md"]), "utf8");
      const logBefore = await readGeneratedFile(wikiDir, "curated/log.md");
      await writeFile(resolve(wikiDir, "curated/log.md"), logBefore.replace(/^visibility: private$/m, "visibility: public"), "utf8");
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [] },
        "# Public Topic\n\nRuntime log link: [log](../log.md).\n",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(issueByRuleAndPath(payload.issues, "public_runtime_log_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        message: expect.stringContaining("runtime log"),
        fixable: false,
      });
      expect(payload.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "public_runtime_log_selected",
          path: "curated/log.md",
        }),
      );
    });
  });

  it("scans large malformed public Markdown and HTML promptly while failing closed on leaks", async () => {
    await withTempWorkspace("llm-wiki-rem-s17-large-malformed-scan-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeFile(resolve(wikiDir, ".llm-wiki/profiles/public.yml"), publicProfileYaml(["curated/topics/public-topic.md"]), "utf8");
      await writeCuratedPage(
        wikiDir,
        "curated/private/secret.md",
        {
          type: "page",
          title: "Secret Page",
          aliases: ["Private Alias"],
          visibility: "private",
          source_ids: [source.source_id],
        },
        "# Secret Page\n\nPrivate detail.\n",
      );
      const noisyMarkdown = Array.from({ length: 800 }, (_, index) =>
        `Paragraph ${index} [unterminated [label ${index}](../raw/not-closed-${index}.md`,
      ).join("\n");
      const noisyHtml = Array.from(
        { length: 800 },
        (_, index) => `<div class="row-${index}" data-note="[not a complete markdown link ${index}">`,
      ).join("\n");
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        `# Public Topic

${noisyMarkdown}

This private wikilink must still be reported: [[Private Alias]].
This raw Markdown link must still be reported: [raw](..%2F..%2Fraw%2Finputs%2F${source.source_id}%2Foriginal.md?download=1#frag).
This local file link must still be reported: [desktop](file:///Users/example/Documents/private-note.md).

${noisyHtml}

<picture>
  <source
    srcset="..&#47;..&#47;raw&#47;inputs&#47;${source.source_id}&#47;original.png 1x,
            public.png 2x"
  >
  <img
    src="public.png"
    poster="file:///tmp/local-poster.png"
    data="file:///tmp/local-data.bin"
  >
</picture>
`,
      );
      const startedAt = performance.now();

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const elapsedMs = performance.now() - startedAt;
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(elapsedMs).toBeLessThan(5_000);
      expect(issueByRuleAndPath(payload.issues, "public_private_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        message: expect.stringContaining("[[Private Alias]]"),
      });
      expect(issueByRuleAndPath(payload.issues, "public_raw_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
      });
      expect(issueByRuleAndPath(payload.issues, "public_local_file_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
      });
    });
  });

  it("fails public strict lint for absolute POSIX local filesystem links", async () => {
    await withTempWorkspace("llm-wiki-rem-s17-posix-local-paths-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeFile(resolve(wikiDir, ".llm-wiki/profiles/public.yml"), publicProfileYaml(["curated/topics/public-topic.md"]), "utf8");
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        `# Public Topic

Links to [mac](/Users/alice/Documents/private.md?download=1#frag), [linux](/home/alice/private.md),
[system](/etc/hosts), and [logs](/var/log/app.log).

<picture>
  <source srcset="/tmp/private-small.png 1x, /Users/alice/private-large.png 2x">
  <img src="/tmp/private.png">
</picture>
`,
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);
      const localIssues = payload.issues.filter(
        (issue) => issue.rule_id === "public_local_file_link" && issue.path === "curated/topics/public-topic.md",
      );
      const messages = localIssues.map((issue) => issue.message).join("\n");

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(issueByRuleAndPath(payload.issues, "public_local_file_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        fixable: false,
      });
      expect(localIssues.length).toBeGreaterThanOrEqual(4);
      expect(messages).toEqual(expect.stringContaining("[mac]"));
      expect(messages).toEqual(expect.stringContaining("[linux]"));
      expect(messages).toEqual(expect.stringContaining("[system]"));
      expect(messages).toEqual(expect.stringContaining("[logs]"));
      expect(messages).toEqual(expect.stringContaining("srcset="));
      expect(messages).toEqual(expect.stringContaining('src="/tmp/private.png"'));
    });
  });

  it("fails public strict lint for absolute POSIX local filesystem links that resolve to public repo files", async () => {
    await withTempWorkspace("llm-wiki-rem-s17-posix-local-resolved-path-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        publicProfileYaml(["curated/topics/public-topic.md", "home/alice/private.md"]),
        "utf8",
      );
      await writeCuratedPage(
        wikiDir,
        "home/alice/private.md",
        { type: "topic", title: "Resolved Public File", visibility: "public", source_ids: [source.source_id] },
        "# Resolved Public File\n\nThis file is public but must not permit absolute local path links.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        "# Public Topic\n\nLinks to [local public file](/home/alice/private.md).\n",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(issueByRuleAndPath(payload.issues, "public_local_file_link", "curated/topics/public-topic.md")).toMatchObject({
        severity: "error",
        message: expect.stringContaining("[local public file]"),
        fixable: false,
      });
    });
  });

  it("allows public strict lint for selected repo-root curated Markdown routes", async () => {
    await withTempWorkspace("llm-wiki-rem-s17-root-relative-public-link-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        publicProfileYaml(["curated/map.md", "curated/topics/source-page.md", "curated/topics/target-page.md"]),
        "utf8",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/map.md",
        { type: "page", title: "Map", visibility: "public", source_ids: [source.source_id] },
        "# Map\n\nPublic root route.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/target-page.md",
        { type: "topic", title: "Target Page", visibility: "public", source_ids: [source.source_id] },
        "# Target Page\n\nPublic target.\n",
      );
      await writeCuratedPage(
        wikiDir,
        "curated/topics/source-page.md",
        { type: "topic", title: "Source Page", visibility: "public", source_ids: [source.source_id] },
        "# Source Page\n\nRoot-relative links to [target](/topics/target-page.md?view=public#target-page) and [map](/map.md).\n",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintSuccess(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "public_local_file_link",
          path: "curated/topics/source-page.md",
        }),
      );
    });
  });

  it("allows public strict lint for site-root Markdown links", async () => {
    await withTempWorkspace("llm-wiki-rem-s17-site-root-public-link-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeFile(resolve(wikiDir, ".llm-wiki/profiles/public.yml"), publicProfileYaml(["curated/topics/public-topic.md"]), "utf8");
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-topic.md",
        { type: "topic", title: "Public Topic", visibility: "public", source_ids: [source.source_id] },
        "# Public Topic\n\nGo back [Home](/).\n",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const payload = parseLintSuccess(result.stdout);

      // Assert
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toEqual([]);
      expect(payload.data.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "public_local_file_link",
          path: "curated/topics/public-topic.md",
        }),
      );
    });
  });

  it("rejects uppercase SHA-256 metadata before raw hash drift checks run", async () => {
    const cases = [
      {
        name: "prefix",
        malformedHash: (hash: string) => hash.replace(/^sha256:/, "SHA256:"),
      },
      {
        name: "hex",
        malformedHash: (hash: string) => `sha256:${hash.slice("sha256:".length).toUpperCase()}`,
      },
    ];

    for (const hashCase of cases) {
      await withTempWorkspace(`llm-wiki-rem-s17-uppercase-hash-${hashCase.name}-`, async (workspaceDir) => {
        // Arrange
        const wikiDir = resolve(workspaceDir, "wiki");
        await initializeWiki(wikiDir);
        const source = await captureSource(wikiDir, workspaceDir);
        const malformedHash = hashCase.malformedHash(source.content_hash);
        const queueRecord = JSON.parse(await readGeneratedFile(wikiDir, source.queue_path)) as Record<string, unknown>;
        await writeFile(
          resolve(wikiDir, source.queue_path),
          `${JSON.stringify({ ...queueRecord, content_hash: malformedHash }, null, 2)}\n`,
          "utf8",
        );
        await writeFile(
          resolve(wikiDir, source.source_card_path),
          (await readGeneratedFile(wikiDir, source.source_card_path)).replace(/^content_hash: .+$/m, `content_hash: ${malformedHash}`),
          "utf8",
        );

        // Act
        const result = await runCliBuffered(["lint", "--repo", wikiDir, "--json"]);
        const payload = parseLintFailure(result.stdout);

        // Assert
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toEqual([]);
        expect(issueByRuleAndPath(payload.issues, "source_card_malformed", source.source_card_path)).toMatchObject({
          severity: "error",
          message: expect.stringContaining("malformed content_hash"),
          fixable: false,
        });
        expect(payload.issues).not.toContainEqual(
          expect.objectContaining({
            rule_id: "raw_hash_drift",
            path: source.original_path,
          }),
        );
        expect(payload.issues).not.toContainEqual(
          expect.objectContaining({
            rule_id: "queue_source_card_mismatch",
            path: source.queue_path,
          }),
        );
      });
    }
  });

  it("rejects malformed queue original paths before raw hash checks run", async () => {
    await withTempWorkspace("llm-wiki-rem-s17-queue-original-path-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      const queueRecord = JSON.parse(await readGeneratedFile(wikiDir, source.queue_path)) as Record<string, unknown>;
      await writeFile(
        resolve(wikiDir, source.queue_path),
        `${JSON.stringify({ ...queueRecord, original_path: "raw/assets/private/original.md" }, null, 2)}\n`,
        "utf8",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(issueByRuleAndPath(payload.issues, "queue_item_malformed", source.queue_path)).toMatchObject({
        severity: "error",
        message: expect.stringContaining("original_path"),
        fixable: false,
      });
      expect(payload.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "raw_original_missing",
          path: "raw/assets/private/original.md",
        }),
      );
    });
  });

  it("rejects missing queue hash metadata before raw hash drift checks run", async () => {
    await withTempWorkspace("llm-wiki-rem-s17-queue-missing-hash-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      const queueRecord = JSON.parse(await readGeneratedFile(wikiDir, source.queue_path)) as Record<string, unknown>;
      const queueWithoutHash = { ...queueRecord };
      delete queueWithoutHash.content_hash;
      await writeFile(resolve(wikiDir, source.queue_path), `${JSON.stringify(queueWithoutHash, null, 2)}\n`, "utf8");

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(issueByRuleAndPath(payload.issues, "queue_source_card_mismatch", source.queue_path)).toMatchObject({
        severity: "error",
        message: expect.stringContaining("content_hash"),
        fixable: false,
      });
      expect(payload.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "raw_hash_drift",
          path: source.original_path,
        }),
      );
    });
  });

  it("rejects queue and source-card hash mismatches before raw hash drift checks run", async () => {
    await withTempWorkspace("llm-wiki-rem-s17-queue-card-hash-mismatch-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      const queueRecord = JSON.parse(await readGeneratedFile(wikiDir, source.queue_path)) as Record<string, unknown>;
      await writeFile(
        resolve(wikiDir, source.queue_path),
        `${JSON.stringify(
          {
            ...queueRecord,
            content_hash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      // Act
      const result = await runCliBuffered(["lint", "--repo", wikiDir, "--json"]);
      const payload = parseLintFailure(result.stdout);

      // Assert
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toEqual([]);
      expect(issueByRuleAndPath(payload.issues, "queue_source_card_mismatch", source.queue_path)).toMatchObject({
        severity: "error",
        message: expect.stringContaining("content_hash"),
        fixable: false,
      });
      expect(payload.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "raw_hash_drift",
          path: source.original_path,
        }),
      );
    });
  });

  it("treats stale public index row content as fixable even when the link text is present", async () => {
    await withTempWorkspace("llm-wiki-rem-s17-public-index-row-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/public-page.md",
        { type: "topic", title: "Public Page", visibility: "public", source_ids: [source.source_id] },
        "# Public Page\n\nPublic notes.\n",
      );
      const indexBefore = await readGeneratedFile(wikiDir, "curated/index.md");
      await writeFile(
        resolve(wikiDir, "curated/index.md"),
        indexBefore
          .replace(/^visibility: private$/m, "visibility: public")
          .replace("## Questions\n", "## Questions\n\n- [[topics/public-page|Public Page]] - stale private row text\n"),
        "utf8",
      );

      // Act
      const staleResult = await runCliBuffered(["lint", "--repo", wikiDir, "--json"]);
      const stalePayload = parseLintSuccess(staleResult.stdout);
      const fixResult = await runCliBuffered(["lint", "--repo", wikiDir, "--fix", "--json"]);
      const fixPayload = parseLintSuccess(fixResult.stdout);
      const fixedIndex = await readGeneratedFile(wikiDir, "curated/index.md");

      // Assert
      expect(staleResult.exitCode).toBe(0);
      expect(issueByRuleAndPath(stalePayload.data.issues, "index_stale", "curated/index.md")).toMatchObject({
        severity: "warning",
        fixable: true,
      });
      expect(fixResult.exitCode).toBe(0);
      expect(fixPayload.data.fixed_paths).toEqual(["curated/index.md"]);
      expect(fixedIndex).toContain("- [[topics/public-page|Public Page]]\n");
      expect(fixedIndex).not.toContain("stale private row text");
    });
  });

  it("fails public strict lint for stale public index rows with bracketed wikilink aliases", async () => {
    await withTempWorkspace("llm-wiki-rem-s17-public-index-bracket-alias-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/bracketed-title.md",
        { type: "topic", title: "Fresh ] Public Title", visibility: "public", source_ids: [source.source_id] },
        "# Fresh ] Public Title\n\nPublic notes.\n",
      );
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        publicProfileYaml(["curated/index.md", "curated/topics/bracketed-title.md"]),
        "utf8",
      );
      const indexBefore = await readGeneratedFile(wikiDir, "curated/index.md");
      await writeFile(
        resolve(wikiDir, "curated/index.md"),
        indexBefore
          .replace(/^visibility: private$/m, "visibility: public")
          .replace("## Topics\n", "## Topics\n\n- [[topics/bracketed-title|Old ] Private Title]] - stale private row text\n"),
        "utf8",
      );

      // Act
      const strictResult = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const strictPayload = parseLintFailure(strictResult.stdout);
      const fixResult = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--fix", "--json"]);
      const fixPayload = parseLintSuccess(fixResult.stdout);
      const fixedIndex = await readGeneratedFile(wikiDir, "curated/index.md");

      // Assert
      expect(strictResult.exitCode).toBe(1);
      expect(strictResult.stderr).toEqual([]);
      expect(issueByRuleAndPath(strictPayload.issues, "public_index_stale_row_leak", "curated/index.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        fixable: true,
      });
      expect(issueByRuleAndPath(strictPayload.issues, "index_stale", "curated/index.md")).toMatchObject({
        severity: "warning",
        fixable: true,
      });
      expect(fixResult.exitCode).toBe(0);
      expect(fixPayload.data.fixed_paths).toEqual(["curated/index.md"]);
      expect(fixedIndex).toContain("- [[topics/bracketed-title|Fresh ] Public Title]]");
      expect(fixedIndex).not.toContain("Old ] Private Title");
      expect(fixedIndex).not.toContain("stale private row text");
    });
  });

  it("fails public strict lint for stale public index rows with unhyphenated appended text", async () => {
    await withTempWorkspace("llm-wiki-rem-s17-public-index-unhyphenated-suffix-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/foo.md",
        { type: "topic", title: "Foo", visibility: "public", source_ids: [source.source_id] },
        "# Foo\n\nPublic notes.\n",
      );
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        publicProfileYaml(["curated/index.md", "curated/topics/foo.md"]),
        "utf8",
      );
      const indexBefore = await readGeneratedFile(wikiDir, "curated/index.md");
      await writeFile(
        resolve(wikiDir, "curated/index.md"),
        indexBefore
          .replace(/^visibility: private$/m, "visibility: public")
          .replace("## Topics\n", "## Topics\n\n- [[topics/foo|Foo]] private note\n"),
        "utf8",
      );

      // Act
      const strictResult = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const strictPayload = parseLintFailure(strictResult.stdout);
      const fixResult = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--fix", "--json"]);
      const fixPayload = parseLintSuccess(fixResult.stdout);
      const fixedIndex = await readGeneratedFile(wikiDir, "curated/index.md");

      // Assert
      expect(strictResult.exitCode).toBe(1);
      expect(strictResult.stderr).toEqual([]);
      expect(issueByRuleAndPath(strictPayload.issues, "public_index_stale_row_leak", "curated/index.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        fixable: true,
      });
      expect(issueByRuleAndPath(strictPayload.issues, "index_stale", "curated/index.md")).toMatchObject({
        severity: "warning",
        fixable: true,
      });
      expect(fixResult.exitCode).toBe(0);
      expect(fixPayload.data.fixed_paths).toEqual(["curated/index.md"]);
      expect(fixedIndex).toContain("- [[topics/foo|Foo]]\n");
      expect(fixedIndex).not.toContain("private note");
    });
  });

  it("fails public strict lint for stale public index rows with spaced list markers", async () => {
    await withTempWorkspace("llm-wiki-rem-s17-public-index-spaced-list-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/spaced-list.md",
        { type: "topic", title: "Spaced List", visibility: "public", source_ids: [source.source_id] },
        "# Spaced List\n\nPublic notes.\n",
      );
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        publicProfileYaml(["curated/index.md", "curated/topics/spaced-list.md"]),
        "utf8",
      );
      const staleListRow = "-  [[topics/spaced-list|Spaced List]] - stale private row text";
      const indexBefore = await readGeneratedFile(wikiDir, "curated/index.md");
      await writeFile(
        resolve(wikiDir, "curated/index.md"),
        indexBefore.replace(/^visibility: private$/m, "visibility: public").replace("## Topics\n", `## Topics\n\n${staleListRow}\n`),
        "utf8",
      );

      // Act
      const strictResult = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const strictPayload = parseLintFailure(strictResult.stdout);
      const fixResult = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--fix", "--json"]);
      const fixPayload = parseLintSuccess(fixResult.stdout);
      const fixedIndex = await readGeneratedFile(wikiDir, "curated/index.md");

      // Assert
      expect(strictResult.exitCode).toBe(1);
      expect(strictResult.stderr).toEqual([]);
      expect(issueByRuleAndPath(strictPayload.issues, "public_index_stale_row_leak", "curated/index.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        fixable: true,
      });
      expect(issueByRuleAndPath(strictPayload.issues, "index_stale", "curated/index.md")).toMatchObject({
        severity: "warning",
        fixable: true,
      });
      expect(fixResult.exitCode).toBe(0);
      expect(fixPayload.data.fixed_paths).toEqual(["curated/index.md"]);
      expect(fixedIndex).toContain("- [[topics/spaced-list|Spaced List]]");
      expect(fixedIndex).not.toContain(staleListRow);
      expect(fixedIndex).not.toContain("stale private row text");
    });
  });

  it("fails public strict lint for stale public index rows after targets become private", async () => {
    await withTempWorkspace("llm-wiki-rem-s17-public-index-private-target-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/old-public-page.md",
        { type: "topic", title: "Old Public Page", visibility: "private", source_ids: [source.source_id] },
        "# Old Public Page\n\nThis page used to be public.\n",
      );
      await writeFile(resolve(wikiDir, ".llm-wiki/profiles/public.yml"), publicProfileYaml(["curated/index.md"]), "utf8");
      const indexBefore = await readGeneratedFile(wikiDir, "curated/index.md");
      await writeFile(
        resolve(wikiDir, "curated/index.md"),
        indexBefore
          .replace(/^visibility: private$/m, "visibility: public")
          .replace("## Topics\n", "## Topics\n\n- [[topics/old-public-page|Old Public Page]] - stale private row text\n"),
        "utf8",
      );

      // Act
      const strictResult = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const strictPayload = parseLintFailure(strictResult.stdout);
      const fixResult = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--fix", "--json"]);
      const fixPayload = parseLintSuccess(fixResult.stdout);
      const fixedIndex = await readGeneratedFile(wikiDir, "curated/index.md");

      // Assert
      expect(strictResult.exitCode).toBe(1);
      expect(strictResult.stderr).toEqual([]);
      expect(issueByRuleAndPath(strictPayload.issues, "public_index_stale_row_leak", "curated/index.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        fixable: true,
      });
      expect(issueByRuleAndPath(strictPayload.issues, "index_stale", "curated/index.md")).toMatchObject({
        severity: "warning",
        fixable: true,
      });
      expect(fixResult.exitCode).toBe(0);
      expect(fixPayload.data.fixed_paths).toEqual(["curated/index.md"]);
      expect(fixedIndex).not.toContain("Old Public Page");
      expect(fixedIndex).not.toContain("stale private row text");
    });
  });

  it("fails public strict lint for stale public index rows after targets are deleted", async () => {
    await withTempWorkspace("llm-wiki-rem-s17-public-index-deleted-target-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      await writeFile(resolve(wikiDir, ".llm-wiki/profiles/public.yml"), publicProfileYaml(["curated/index.md"]), "utf8");
      const indexBefore = await readGeneratedFile(wikiDir, "curated/index.md");
      await writeFile(
        resolve(wikiDir, "curated/index.md"),
        indexBefore
          .replace(/^visibility: private$/m, "visibility: public")
          .replace("## Topics\n", "## Topics\n\n- [[topics/deleted-page|Deleted Page]] - stale private row text\n"),
        "utf8",
      );

      // Act
      const strictResult = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const strictPayload = parseLintFailure(strictResult.stdout);
      const fixResult = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--fix", "--json"]);
      const fixPayload = parseLintSuccess(fixResult.stdout);
      const fixedIndex = await readGeneratedFile(wikiDir, "curated/index.md");

      // Assert
      expect(strictResult.exitCode).toBe(1);
      expect(strictResult.stderr).toEqual([]);
      expect(issueByRuleAndPath(strictPayload.issues, "public_index_stale_row_leak", "curated/index.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        fixable: true,
      });
      expect(issueByRuleAndPath(strictPayload.issues, "index_stale", "curated/index.md")).toMatchObject({
        severity: "warning",
        fixable: true,
      });
      expect(fixResult.exitCode).toBe(0);
      expect(fixPayload.data.fixed_paths).toEqual(["curated/index.md"]);
      expect(fixedIndex).not.toContain("Deleted Page");
      expect(fixedIndex).not.toContain("stale private row text");
    });
  });

  it("does not treat manual index bullets in a current index as stale generated rows", async () => {
    await withTempWorkspace("llm-wiki-rem-s17-public-index-manual-bullet-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeCuratedPage(
        wikiDir,
        "curated/topics/foo.md",
        { type: "topic", title: "Foo", visibility: "public", source_ids: [source.source_id] },
        "# Foo\n\nPublic notes.\n",
      );
      const indexBefore = await readGeneratedFile(wikiDir, "curated/index.md");
      await writeFile(resolve(wikiDir, "curated/index.md"), indexBefore.replace(/^visibility: private$/m, "visibility: public"), "utf8");
      const initialFixResult = await runCliBuffered(["lint", "--repo", wikiDir, "--fix", "--json"]);
      expect(initialFixResult.exitCode).toBe(0);
      const currentIndex = await readGeneratedFile(wikiDir, "curated/index.md");
      const indexWithManualBullet = currentIndex.replace(
        "## Overview\n",
        "## Overview\n\n- [[topics/foo|Foo]] is important\n",
      );
      expect(currentIndex).toContain("- [[topics/foo|Foo]]\n");
      expect(indexWithManualBullet).toContain("- [[topics/foo|Foo]] is important");
      await writeFile(resolve(wikiDir, "curated/index.md"), indexWithManualBullet, "utf8");

      // Act
      const lintResult = await runCliBuffered(["lint", "--repo", wikiDir, "--json"]);
      const lintPayload = parseLintSuccess(lintResult.stdout);
      const fixResult = await runCliBuffered(["lint", "--repo", wikiDir, "--fix", "--json"]);
      const fixPayload = parseLintSuccess(fixResult.stdout);

      // Assert
      expect(lintResult.exitCode).toBe(0);
      expect(lintPayload.data.issues).not.toContainEqual(
        expect.objectContaining({
          rule_id: "index_stale",
          path: "curated/index.md",
        }),
      );
      expect(fixResult.exitCode).toBe(0);
      expect(fixPayload.data.fixed_paths).toEqual([]);
      expect(await readGeneratedFile(wikiDir, "curated/index.md")).toBe(indexWithManualBullet);
    });
  });

  it("fails public strict lint for stale public source-summary index row content", async () => {
    await withTempWorkspace("llm-wiki-rem-s17-public-summary-index-row-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeCuratedPage(
        wikiDir,
        `curated/sources/${source.source_id}.md`,
        { type: "source_summary", title: "Public Source Summary", visibility: "public", source_ids: [source.source_id] },
        "# Public Source Summary\n\nReviewed public summary.\n",
      );
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        publicProfileYaml(["curated/index.md", `curated/sources/${source.source_id}.md`]),
        "utf8",
      );
      const sourceSummaryRow = `| [[sources/${source.source_id}|Public Source Summary]] | | | |`;
      const indexBefore = await readGeneratedFile(wikiDir, "curated/index.md");
      await writeFile(
        resolve(wikiDir, "curated/index.md"),
        indexBefore
          .replace(/^visibility: private$/m, "visibility: public")
          .replace("|---|---|---|---|\n", `|---|---|---|---|\n${sourceSummaryRow} stale private row text\n`),
        "utf8",
      );

      // Act
      const strictResult = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const strictPayload = parseLintFailure(strictResult.stdout);
      const fixResult = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--fix", "--json"]);
      const fixPayload = parseLintSuccess(fixResult.stdout);
      const fixedIndex = await readGeneratedFile(wikiDir, "curated/index.md");

      // Assert
      expect(strictResult.exitCode).toBe(1);
      expect(strictResult.stderr).toEqual([]);
      expect(issueByRuleAndPath(strictPayload.issues, "public_index_stale_row_leak", "curated/index.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        fixable: true,
      });
      expect(issueByRuleAndPath(strictPayload.issues, "index_stale", "curated/index.md")).toMatchObject({
        severity: "warning",
        fixable: true,
      });
      expect(fixResult.exitCode).toBe(0);
      expect(fixPayload.data.fixed_paths).toEqual(["curated/index.md"]);
      expect(fixedIndex).not.toContain("stale private row text");
      expect(fixedIndex).not.toContain(sourceSummaryRow);
    });
  });

  it("fails public strict lint for stale public source-summary index rows without raw source cards", async () => {
    await withTempWorkspace("llm-wiki-rem-s17-public-summary-index-missing-card-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeCuratedPage(
        wikiDir,
        `curated/sources/${source.source_id}.md`,
        { type: "source_summary", title: "Public Source Summary", visibility: "public", source_ids: [source.source_id] },
        "# Public Source Summary\n\nReviewed public summary.\n",
      );
      await rm(resolve(wikiDir, source.source_card_path), { force: true });
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        publicProfileYaml(["curated/index.md", `curated/sources/${source.source_id}.md`]),
        "utf8",
      );
      const sourceSummaryRow = `| [[sources/${source.source_id}|Public Source Summary]] | stale private text | | |`;
      const indexBefore = await readGeneratedFile(wikiDir, "curated/index.md");
      await writeFile(
        resolve(wikiDir, "curated/index.md"),
        indexBefore.replace(/^visibility: private$/m, "visibility: public").replace("|---|---|---|---|\n", `|---|---|---|---|\n${sourceSummaryRow}\n`),
        "utf8",
      );

      // Act
      const strictResult = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const strictPayload = parseLintFailure(strictResult.stdout);

      // Assert
      expect(strictResult.exitCode).toBe(1);
      expect(strictResult.stderr).toEqual([]);
      expect(issueByRuleAndPath(strictPayload.issues, "public_index_stale_row_leak", "curated/index.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        fixable: true,
      });
    });
  });

  it("fails public strict lint for stale public source-summary index rows after title changes", async () => {
    await withTempWorkspace("llm-wiki-rem-s17-public-summary-index-title-change-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeCuratedPage(
        wikiDir,
        `curated/sources/${source.source_id}.md`,
        { type: "source_summary", title: "New Public Title", visibility: "public", source_ids: [source.source_id] },
        "# New Public Title\n\nReviewed public summary.\n",
      );
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        publicProfileYaml(["curated/index.md", `curated/sources/${source.source_id}.md`]),
        "utf8",
      );
      const staleSourceSummaryRow = `| [[sources/${source.source_id}|Old Private Title]] | | | |`;
      const indexBefore = await readGeneratedFile(wikiDir, "curated/index.md");
      await writeFile(
        resolve(wikiDir, "curated/index.md"),
        indexBefore
          .replace(/^visibility: private$/m, "visibility: public")
          .replace("|---|---|---|---|\n", `|---|---|---|---|\n${staleSourceSummaryRow}\n`),
        "utf8",
      );

      // Act
      const strictResult = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const strictPayload = parseLintFailure(strictResult.stdout);
      const fixResult = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--fix", "--json"]);
      const fixPayload = parseLintSuccess(fixResult.stdout);
      const fixedIndex = await readGeneratedFile(wikiDir, "curated/index.md");

      // Assert
      expect(strictResult.exitCode).toBe(1);
      expect(strictResult.stderr).toEqual([]);
      expect(issueByRuleAndPath(strictPayload.issues, "public_index_stale_row_leak", "curated/index.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        fixable: true,
      });
      expect(issueByRuleAndPath(strictPayload.issues, "index_stale", "curated/index.md")).toMatchObject({
        severity: "warning",
        fixable: true,
      });
      expect(fixResult.exitCode).toBe(0);
      expect(fixPayload.data.fixed_paths).toEqual(["curated/index.md"]);
      expect(fixedIndex).not.toContain("Old Private Title");
    });
  });

  it("fails public strict lint for stale public source-summary index row table cells", async () => {
    await withTempWorkspace("llm-wiki-rem-s17-public-summary-index-row-cells-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir);
      await writeCuratedPage(
        wikiDir,
        `curated/sources/${source.source_id}.md`,
        { type: "source_summary", title: "Public Source Summary", visibility: "public", source_ids: [source.source_id] },
        "# Public Source Summary\n\nReviewed public summary.\n",
      );
      await writeFile(
        resolve(wikiDir, ".llm-wiki/profiles/public.yml"),
        publicProfileYaml(["curated/index.md", `curated/sources/${source.source_id}.md`]),
        "utf8",
      );
      const sourceSummaryLink = `[[sources/${source.source_id}|Public Source Summary]]`;
      const staleSourceSummaryRow = `| ${sourceSummaryLink} | private appended cell | | |`;
      const indexBefore = await readGeneratedFile(wikiDir, "curated/index.md");
      await writeFile(
        resolve(wikiDir, "curated/index.md"),
        indexBefore
          .replace(/^visibility: private$/m, "visibility: public")
          .replace("|---|---|---|---|\n", `|---|---|---|---|\n${staleSourceSummaryRow}\n`),
        "utf8",
      );

      // Act
      const strictResult = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const strictPayload = parseLintFailure(strictResult.stdout);
      const fixResult = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--fix", "--json"]);
      const fixPayload = parseLintSuccess(fixResult.stdout);
      const fixedIndex = await readGeneratedFile(wikiDir, "curated/index.md");

      // Assert
      expect(strictResult.exitCode).toBe(1);
      expect(strictResult.stderr).toEqual([]);
      expect(issueByRuleAndPath(strictPayload.issues, "public_index_stale_row_leak", "curated/index.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        fixable: true,
      });
      expect(issueByRuleAndPath(strictPayload.issues, "index_stale", "curated/index.md")).toMatchObject({
        severity: "warning",
        fixable: true,
      });
      expect(fixResult.exitCode).toBe(0);
      expect(fixPayload.data.fixed_paths).toEqual(["curated/index.md"]);
      expect(fixedIndex).not.toContain("private appended cell");
      expect(fixedIndex).not.toContain(sourceSummaryLink);
    });
  });

  it("fails public strict lint for title-only stale source rows without source artifacts", async () => {
    await withTempWorkspace("llm-wiki-rem-s17-public-index-title-only-source-row-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir, "Secret Diagnosis", "# Secret Diagnosis\n\nPrivate raw note.\n");
      await rm(resolve(wikiDir, dirname(source.source_card_path)), { recursive: true, force: true });
      await rm(resolve(wikiDir, source.queue_path), { force: true });
      await writeFile(resolve(wikiDir, ".llm-wiki/profiles/public.yml"), publicProfileYaml(["curated/index.md"]), "utf8");
      const staleSourceRow = "| Secret Diagnosis | queued | | |";
      const indexBefore = await readGeneratedFile(wikiDir, "curated/index.md");
      await writeFile(
        resolve(wikiDir, "curated/index.md"),
        indexBefore.replace(/^visibility: private$/m, "visibility: public").replace("|---|---|---|---|\n", `|---|---|---|---|\n${staleSourceRow}\n`),
        "utf8",
      );

      // Act
      const strictResult = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const strictPayload = parseLintFailure(strictResult.stdout);
      const fixResult = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--fix", "--json"]);
      const fixPayload = parseLintSuccess(fixResult.stdout);
      const fixedIndex = await readGeneratedFile(wikiDir, "curated/index.md");

      // Assert
      expect(strictResult.exitCode).toBe(1);
      expect(strictResult.stderr).toEqual([]);
      expect(issueByRuleAndPath(strictPayload.issues, "public_index_stale_row_leak", "curated/index.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        fixable: true,
      });
      expect(issueByRuleAndPath(strictPayload.issues, "index_stale", "curated/index.md")).toMatchObject({
        severity: "warning",
        fixable: true,
      });
      expect(fixResult.exitCode).toBe(0);
      expect(fixPayload.data.fixed_paths).toEqual(["curated/index.md"]);
      expect(fixedIndex).not.toContain(staleSourceRow);
      expect(fixedIndex).not.toContain("Secret Diagnosis");
    });
  });

  it("fails public strict lint for appended title-only stale source rows without source artifacts", async () => {
    await withTempWorkspace("llm-wiki-rem-s17-public-index-appended-source-row-", async (workspaceDir) => {
      // Arrange
      const wikiDir = resolve(workspaceDir, "wiki");
      await initializeWiki(wikiDir);
      const source = await captureSource(wikiDir, workspaceDir, "Secret Diagnosis", "# Secret Diagnosis\n\nPrivate raw note.\n");
      await rm(resolve(wikiDir, dirname(source.source_card_path)), { recursive: true, force: true });
      await rm(resolve(wikiDir, source.queue_path), { force: true });
      await writeFile(resolve(wikiDir, ".llm-wiki/profiles/public.yml"), publicProfileYaml(["curated/index.md"]), "utf8");
      const staleSourceRow = "| Secret Diagnosis | queued | | | private note";
      const indexBefore = await readGeneratedFile(wikiDir, "curated/index.md");
      await writeFile(
        resolve(wikiDir, "curated/index.md"),
        indexBefore.replace(/^visibility: private$/m, "visibility: public").replace("|---|---|---|---|\n", `|---|---|---|---|\n${staleSourceRow}\n`),
        "utf8",
      );

      // Act
      const strictResult = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--json"]);
      const strictPayload = parseLintFailure(strictResult.stdout);
      const fixResult = await runCliBuffered(["lint", "--repo", wikiDir, "--profile", "public", "--strict", "--fix", "--json"]);
      const fixPayload = parseLintSuccess(fixResult.stdout);
      const fixedIndex = await readGeneratedFile(wikiDir, "curated/index.md");

      // Assert
      expect(strictResult.exitCode).toBe(1);
      expect(strictResult.stderr).toEqual([]);
      expect(issueByRuleAndPath(strictPayload.issues, "public_index_stale_row_leak", "curated/index.md")).toMatchObject({
        severity: "error",
        line: expect.any(Number),
        fixable: true,
      });
      expect(issueByRuleAndPath(strictPayload.issues, "index_stale", "curated/index.md")).toMatchObject({
        severity: "warning",
        fixable: true,
      });
      expect(fixResult.exitCode).toBe(0);
      expect(fixPayload.data.fixed_paths).toEqual(["curated/index.md"]);
      expect(fixedIndex).not.toContain(staleSourceRow);
      expect(fixedIndex).not.toContain("Secret Diagnosis");
      expect(fixedIndex).not.toContain("private note");
    });
  });
});
