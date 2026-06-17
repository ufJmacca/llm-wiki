import { describe, expect, it } from "vitest";

import { planWikiScaffold } from "../src/scaffold/files.js";
import {
  computeContentHash,
  parseCacheMetadata,
  parseProfile,
  parseQueueItem,
  parseSourceId,
  parseWikilinks,
  scanMarkdownDocument,
} from "../src/scanner/index.js";

const defaultOptions = {
  agent: "generic",
  obsidian: false,
  dataview: true,
  git: true,
} as const;

describe("scanner frontmatter and runtime schema compatibility", () => {
  it("parses scaffold raw source cards using raw_source and source_kind", () => {
    // Arrange
    const plannedEntries = new Map(planWikiScaffold(defaultOptions).map((entry) => [entry.path, entry.content]));
    const sourceCard = plannedEntries.get(".llm-wiki/templates/source-card.md");

    // Act
    const scan = scanMarkdownDocument({
      path: "raw/inputs/2026/06/src_2026_06_17_research_note_a1b2c3d4/_source.md",
      content: sourceCard ?? "",
    });

    // Assert
    expect(scan.issues).toEqual([]);
    expect(scan.frontmatter).toMatchObject({
      type: "raw_source",
      source_kind: null,
      visibility: "private",
      status: "queued",
    });
    expect(scan.frontmatter).toHaveProperty("source_kind");
    expect(scan.frontmatter).not.toHaveProperty("kind");
  });

  it("reports malformed frontmatter with path, line, and fix hint", () => {
    // Arrange
    const content = `---
type: [
---
# Broken
`;

    // Act
    const scan = scanMarkdownDocument({ path: "curated/broken.md", content });

    // Assert
    expect(scan.frontmatter).toBeUndefined();
    expect(scan.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "FRONTMATTER_YAML_INVALID",
        path: "curated/broken.md",
        line: 2,
        hint: expect.stringContaining("Fix the YAML frontmatter"),
      }),
    ]);
  });

  it("reports frontmatter YAML conversion failures as scanner issues", () => {
    // Arrange
    const content = `---
title: *missing
---
# Broken
`;

    // Act
    const scan = scanMarkdownDocument({ path: "curated/broken.md", content });

    // Assert
    expect(scan.frontmatter).toBeUndefined();
    expect(scan.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "FRONTMATTER_YAML_INVALID",
        path: "curated/broken.md",
        line: 2,
        hint: expect.stringContaining("Fix the YAML frontmatter"),
      }),
    ]);
  });

  it("preserves indented delimiter text inside frontmatter block scalars", () => {
    // Arrange
    const content = `---
type: topic
title: Research notes
description: |
  keep this delimiter text
  ---
  inside the YAML scalar
source_ids:
  - src_2026_06_17_research_note_a1b2c3
---
# Body
`;

    // Act
    const scan = scanMarkdownDocument({ path: "curated/research-notes.md", content });

    // Assert
    expect(scan.issues).toEqual([]);
    expect(scan.frontmatter).toMatchObject({
      type: "topic",
      title: "Research notes",
      source_ids: ["src_2026_06_17_research_note_a1b2c3"],
    });
    expect(scan.frontmatter?.description).toContain("---");
    expect(scan.body).toBe("# Body\n");
    expect(scan.headings).toEqual([
      {
        path: "curated/research-notes.md",
        line: 11,
        depth: 1,
        text: "Body",
      },
    ]);
  });

  it("returns frontmatter-stripped body and heading metadata while ignoring fenced headings", () => {
    // Arrange
    const content = `---
type: topic
title: Research notes
---

# Overview
Body text.

\`\`\`markdown
## Ignored fenced heading
\`\`\`

## Findings
More body text.
`;

    // Act
    const scan = scanMarkdownDocument({ path: "curated/research-notes.md", content });

    // Assert
    expect(scan.issues).toEqual([]);
    expect(scan.body).toBe(`# Overview
Body text.

\`\`\`markdown
## Ignored fenced heading
\`\`\`

## Findings
More body text.
`);
    expect(scan.headings).toEqual([
      {
        path: "curated/research-notes.md",
        line: 6,
        depth: 1,
        text: "Overview",
      },
      {
        path: "curated/research-notes.md",
        line: 13,
        depth: 2,
        text: "Findings",
      },
    ]);
  });

  it("parses full ATX heading syntax with indentation and closing hash sequences", () => {
    // Arrange
    const content = `# Overview
   ### Indented heading
## Closed heading ##
### Closed with whitespace ###   
    ## Indented code heading
#### Heading ### text
`;

    // Act
    const scan = scanMarkdownDocument({ path: "curated/research-notes.md", content });

    // Assert
    expect(scan.headings).toEqual([
      {
        path: "curated/research-notes.md",
        line: 1,
        depth: 1,
        text: "Overview",
      },
      {
        path: "curated/research-notes.md",
        line: 2,
        depth: 3,
        text: "Indented heading",
      },
      {
        path: "curated/research-notes.md",
        line: 3,
        depth: 2,
        text: "Closed heading",
      },
      {
        path: "curated/research-notes.md",
        line: 4,
        depth: 3,
        text: "Closed with whitespace",
      },
      {
        path: "curated/research-notes.md",
        line: 6,
        depth: 4,
        text: "Heading ### text",
      },
    ]);
  });

  it("ignores headings and wikilinks inside tilde fences that contain backtick examples", () => {
    // Arrange
    const content = `# Overview

~~~markdown
\`\`\`markdown
## Ignored mixed-fence heading
[[Ignored Mixed Link]]
\`\`\`
~~~

## Findings
[[Visible Link]]
`;

    // Act
    const scan = scanMarkdownDocument({ path: "curated/research-notes.md", content });

    // Assert
    expect(scan.headings).toEqual([
      {
        path: "curated/research-notes.md",
        line: 1,
        depth: 1,
        text: "Overview",
      },
      {
        path: "curated/research-notes.md",
        line: 10,
        depth: 2,
        text: "Findings",
      },
    ]);
    expect(scan.wikilinks).toEqual([
      {
        path: "curated/research-notes.md",
        line: 11,
        column: 1,
        raw: "[[Visible Link]]",
        target: "Visible Link",
        alias: null,
        embed: false,
      },
    ]);
  });

  it("preserves longer fence markers when ignoring headings and wikilinks", () => {
    // Arrange
    const content = `# Overview

\`\`\`\`markdown
\`\`\`markdown
## Ignored longer-fence heading
[[Ignored Longer Fence Link]]
\`\`\`
\`\`\`\`

## Findings
[[Visible Link]]
`;

    // Act
    const scan = scanMarkdownDocument({ path: "curated/research-notes.md", content });

    // Assert
    expect(scan.headings).toEqual([
      {
        path: "curated/research-notes.md",
        line: 1,
        depth: 1,
        text: "Overview",
      },
      {
        path: "curated/research-notes.md",
        line: 10,
        depth: 2,
        text: "Findings",
      },
    ]);
    expect(scan.wikilinks).toEqual([
      {
        path: "curated/research-notes.md",
        line: 11,
        column: 1,
        raw: "[[Visible Link]]",
        target: "Visible Link",
        alias: null,
        embed: false,
      },
    ]);
  });

  it("ignores headings and wikilinks until a matching Markdown closing fence", () => {
    // Arrange
    const content = `# Overview

\`\`\`markdown
\`\`\`ts
## Ignored info-string fence line
[[Ignored Link]]
    \`\`\`
## Still ignored after indented backticks
\`\`\`

## Findings
[[Visible Link]]
`;

    // Act
    const scan = scanMarkdownDocument({ path: "curated/research-notes.md", content });

    // Assert
    expect(scan.headings).toEqual([
      {
        path: "curated/research-notes.md",
        line: 1,
        depth: 1,
        text: "Overview",
      },
      {
        path: "curated/research-notes.md",
        line: 11,
        depth: 2,
        text: "Findings",
      },
    ]);
    expect(scan.wikilinks).toEqual([
      {
        path: "curated/research-notes.md",
        line: 12,
        column: 1,
        raw: "[[Visible Link]]",
        target: "Visible Link",
        alias: null,
        embed: false,
      },
    ]);
  });
});

describe("scanner structured input parsing", () => {
  it("parses profile YAML and reports malformed profiles as scanner issues", () => {
    // Arrange
    const validProfile = `name: public
mode: deploy
include:
  - curated/**
visibility:
  include_private: false
  required_value: public
`;
    const malformedProfile = `name: [
mode: deploy
`;

    // Act
    const validScan = parseProfile({ path: ".llm-wiki/profiles/public.yml", content: validProfile });
    const malformedScan = parseProfile({ path: ".llm-wiki/profiles/public.yml", content: malformedProfile });

    // Assert
    expect(validScan.issues).toEqual([]);
    expect(validScan.profile).toMatchObject({
      name: "public",
      mode: "deploy",
      include: ["curated/**"],
    });
    expect(malformedScan.profile).toBeUndefined();
    expect(malformedScan.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "PROFILE_YAML_INVALID",
        path: ".llm-wiki/profiles/public.yml",
        line: 1,
        hint: expect.stringContaining("Fix the profile YAML"),
      }),
    ]);
  });

  it("reports profile YAML conversion failures as scanner issues", () => {
    // Arrange
    const conversionFailureProfile = `name: *missing
mode: deploy
include: []
`;

    // Act
    const scan = parseProfile({ path: ".llm-wiki/profiles/public.yml", content: conversionFailureProfile });

    // Assert
    expect(scan.profile).toBeUndefined();
    expect(scan.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "PROFILE_YAML_INVALID",
        path: ".llm-wiki/profiles/public.yml",
        line: 1,
        hint: expect.stringContaining("Fix the profile YAML"),
      }),
    ]);
  });

  it("reports parseable profile schema errors with structured issue metadata", () => {
    // Arrange
    const schemaInvalidProfile = `name: public
mode: deploy
include: curated/**
visibility:
  include_private: "false"
  required_value: public
`;

    // Act
    const scan = parseProfile({ path: ".llm-wiki/profiles/public.yml", content: schemaInvalidProfile });

    // Assert
    expect(scan.profile).toBeUndefined();
    expect(scan.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "PROFILE_INCLUDE_INVALID",
        path: ".llm-wiki/profiles/public.yml",
        hint: expect.stringContaining("Use an array of glob strings"),
      }),
      expect.objectContaining({
        severity: "error",
        code: "PROFILE_VISIBILITY_INVALID",
        path: ".llm-wiki/profiles/public.yml",
        hint: expect.stringContaining("Use a boolean visibility.include_private value"),
      }),
    ]);
  });

  it("parses queue JSON and reports malformed queue files as scanner issues", () => {
    // Arrange
    const validQueue = JSON.stringify({
      source_id: "src_2026_06_17_research_note_a1b2c3d4",
      title: "Research note",
      kind: "file",
      status: "queued",
      path: "raw/inputs/2026/06/src_2026_06_17_research_note_a1b2c3d4/_source.md",
    });
    const malformedQueue = `{"source_id" 1}`;

    // Act
    const validScan = parseQueueItem({
      path: "raw/queue/src_2026_06_17_research_note_a1b2c3d4.json",
      content: validQueue,
    });
    const malformedScan = parseQueueItem({
      path: "raw/queue/src_2026_06_17_research_note_a1b2c3d4.json",
      content: malformedQueue,
    });

    // Assert
    expect(validScan.issues).toEqual([]);
    expect(validScan.item).toMatchObject({
      source_id: "src_2026_06_17_research_note_a1b2c3d4",
      title: "Research note",
      kind: "file",
      status: "queued",
    });
    expect(malformedScan.item).toBeUndefined();
    expect(malformedScan.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "QUEUE_JSON_INVALID",
        path: "raw/queue/src_2026_06_17_research_note_a1b2c3d4.json",
        line: 1,
        hint: expect.stringContaining("Fix the queue JSON"),
      }),
    ]);
  });

  it("does not invent locations for malformed JSON when the parser omits a position", () => {
    // Arrange
    const malformedQueue = `{
  "source_id": "src_2026_06_17_research_note_a1b2c3d4",
  "title": "Research note",
  "kind": "file",
  "status": "queued",
  "path": `;
    const malformedCache = `{
  "generated_at": "2026-06-17T11:28:42.000Z",
  "files": [`;

    // Act
    const queueScan = parseQueueItem({
      path: "raw/queue/src_2026_06_17_research_note_a1b2c3d4.json",
      content: malformedQueue,
    });
    const cacheScan = parseCacheMetadata({
      path: ".llm-wiki/cache/quartz-manifest.local.json",
      content: malformedCache,
    });

    // Assert
    expect(queueScan.item).toBeUndefined();
    expect(queueScan.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "QUEUE_JSON_INVALID",
        path: "raw/queue/src_2026_06_17_research_note_a1b2c3d4.json",
        hint: expect.stringContaining("Fix the queue JSON"),
      }),
    ]);
    expect(queueScan.issues[0]).not.toHaveProperty("line");
    expect(queueScan.issues[0]).not.toHaveProperty("column");
    expect(cacheScan.metadata).toBeUndefined();
    expect(cacheScan.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "CACHE_JSON_INVALID",
        path: ".llm-wiki/cache/quartz-manifest.local.json",
        hint: expect.stringContaining("Regenerate the cache metadata"),
      }),
    ]);
    expect(cacheScan.issues[0]).not.toHaveProperty("line");
    expect(cacheScan.issues[0]).not.toHaveProperty("column");
  });

  it("reports malformed CRLF queue and cache JSON locations against original input offsets", () => {
    // Arrange
    const malformedQueue = `{\r
  "source_id": "src_2026_06_17_research_note_a1b2c3d4",\r
  "title" "Research note"\r
}`;
    const malformedCache = `{\r
  "generated_at": "2026-06-17T11:28:42.000Z",\r
  "files" []\r
}`;

    // Act
    const queueScan = parseQueueItem({
      path: "raw/queue/src_2026_06_17_research_note_a1b2c3d4.json",
      content: malformedQueue,
    });
    const cacheScan = parseCacheMetadata({
      path: ".llm-wiki/cache/quartz-manifest.local.json",
      content: malformedCache,
    });

    // Assert
    expect(queueScan.item).toBeUndefined();
    expect(queueScan.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "QUEUE_JSON_INVALID",
        path: "raw/queue/src_2026_06_17_research_note_a1b2c3d4.json",
        line: 3,
        column: 11,
        hint: expect.stringContaining("Fix the queue JSON"),
      }),
    ]);
    expect(cacheScan.metadata).toBeUndefined();
    expect(cacheScan.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "CACHE_JSON_INVALID",
        path: ".llm-wiki/cache/quartz-manifest.local.json",
        line: 3,
        column: 11,
        hint: expect.stringContaining("Regenerate the cache metadata"),
      }),
    ]);
  });

  it("reports parseable queue schema errors with structured issue metadata", () => {
    // Arrange
    const schemaInvalidQueue = JSON.stringify({
      source_id: "not-a-source-id",
      title: "Research note",
      status: "archived",
      path: "raw/inputs/2026/06/not-a-source-id/_source.md",
    });

    // Act
    const scan = parseQueueItem({
      path: "raw/queue/not-a-source-id.json",
      content: schemaInvalidQueue,
    });

    // Assert
    expect(scan.item).toBeUndefined();
    expect(scan.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "QUEUE_FIELD_MISSING",
        path: "raw/queue/not-a-source-id.json",
        hint: expect.stringContaining('Add a non-empty "kind" value'),
      }),
      expect.objectContaining({
        severity: "error",
        code: "SOURCE_ID_INVALID",
        path: "raw/queue/not-a-source-id.json",
        hint: expect.stringContaining("Use source IDs shaped like"),
      }),
      expect.objectContaining({
        severity: "error",
        code: "QUEUE_STATUS_INVALID",
        path: "raw/queue/not-a-source-id.json",
        hint: expect.stringContaining("Use one of queued, ingesting, ingested, or blocked"),
      }),
    ]);
  });

  it("parses source IDs, raw content hashes, and generated cache metadata without making caches authoritative", () => {
    // Arrange
    const sourceId = "src_2026_06_17_research_note_a1b2c3d4";
    const content = Buffer.from("raw note\n", "utf8");
    const cacheJson = JSON.stringify({
      generated_at: "2026-06-17T11:28:42.000Z",
      profile: "local",
      files: [
        {
          source: "curated/home.md",
          output: "quartz/content/home.md",
          content_hash: computeContentHash("home\n"),
        },
      ],
    });

    // Act
    const parsedSourceId = parseSourceId(sourceId);
    const firstHash = computeContentHash(content);
    const secondHash = computeContentHash(content);
    const differentHash = computeContentHash("different raw note\n");
    const cacheScan = parseCacheMetadata({ path: ".llm-wiki/cache/quartz-manifest.local.json", content: cacheJson });

    // Assert
    expect(parsedSourceId).toEqual({
      ok: true,
      value: {
        sourceId,
        year: "2026",
        month: "06",
        day: "17",
        slug: "research_note",
        shortHash: "a1b2c3d4",
      },
    });
    expect(firstHash).toBe(secondHash);
    expect(firstHash).toBe("sha256:71d616d60b1c297cb6f79990a06230dd958a87df9b8d6751eb6deb4e2967169c");
    expect(differentHash).not.toBe(firstHash);
    expect(cacheScan.issues).toEqual([]);
    expect(cacheScan.authoritative).toBe(false);
    expect(cacheScan.metadata).toMatchObject({
      profile: "local",
      files: [
        {
          source: "curated/home.md",
          output: "quartz/content/home.md",
        },
      ],
    });
  });

  it("accepts documented six-character source ID short hashes", () => {
    // Arrange
    const sourceId = "src_2026_06_15_karpathy_llm_wiki_a1b2c3";

    // Act
    const parsedSourceId = parseSourceId(sourceId);
    const invalidSourceId = parseSourceId("src_2026_06_15_karpathy_llm_wiki_a1b2");

    // Assert
    expect(parsedSourceId).toEqual({
      ok: true,
      value: {
        sourceId,
        year: "2026",
        month: "06",
        day: "15",
        slug: "karpathy_llm_wiki",
        shortHash: "a1b2c3",
      },
    });
    expect(invalidSourceId).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "SOURCE_ID_INVALID",
      }),
    });
  });

  it("rejects source IDs with impossible calendar dates in queue items and source cards", () => {
    // Arrange
    const invalidMonthSourceId = "src_2026_99_99_research_note_a1b2c3";
    const invalidDaySourceId = "src_2026_02_31_research_note_a1b2c3";
    const queuePath = `raw/queue/${invalidMonthSourceId}.json`;
    const sourceCardPath = `raw/inputs/2026/02/${invalidDaySourceId}/_source.md`;
    const queueContent = JSON.stringify({
      source_id: invalidMonthSourceId,
      title: "Research note",
      kind: "file",
      status: "queued",
      path: `raw/inputs/2026/99/${invalidMonthSourceId}/_source.md`,
    });
    const sourceCardContent = `---
type: raw_source
source_id: ${invalidDaySourceId}
title: Research note
source_kind: file
status: queued
visibility: private
---
# Research note
`;

    // Act
    const invalidMonth = parseSourceId(invalidMonthSourceId);
    const invalidDay = parseSourceId(invalidDaySourceId);
    const queueScan = parseQueueItem({ path: queuePath, content: queueContent });
    const sourceCardScan = scanMarkdownDocument({ path: sourceCardPath, content: sourceCardContent });

    // Assert
    expect(invalidMonth).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "SOURCE_ID_INVALID",
        hint: expect.stringContaining("real calendar date"),
      }),
    });
    expect(invalidDay).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "SOURCE_ID_INVALID",
        hint: expect.stringContaining("real calendar date"),
      }),
    });
    expect(queueScan.item).toBeUndefined();
    expect(queueScan.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "SOURCE_ID_INVALID",
        path: queuePath,
        hint: expect.stringContaining("real calendar date"),
      }),
    ]);
    expect(sourceCardScan.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "SOURCE_ID_INVALID",
        path: sourceCardPath,
        hint: expect.stringContaining("real calendar date"),
      }),
    ]);
  });
});

describe("scanner wikilink parsing", () => {
  it("parses Obsidian-style wikilinks and aliases while ignoring code fences", () => {
    // Arrange
    const content = `# Page

Links to [[Plain Page]], [[target-page|Alias]], and ![[assets/image.png|Image]].

\`\`\`markdown
[[Ignored Example]]
\`\`\`
`;

    // Act
    const links = parseWikilinks({ path: "curated/page.md", content });

    // Assert
    expect(links).toEqual([
      {
        path: "curated/page.md",
        line: 3,
        column: 10,
        raw: "[[Plain Page]]",
        target: "Plain Page",
        alias: null,
        embed: false,
      },
      {
        path: "curated/page.md",
        line: 3,
        column: 26,
        raw: "[[target-page|Alias]]",
        target: "target-page",
        alias: "Alias",
        embed: false,
      },
      {
        path: "curated/page.md",
        line: 3,
        column: 53,
        raw: "![[assets/image.png|Image]]",
        target: "assets/image.png",
        alias: "Image",
        embed: true,
      },
    ]);
  });

  it("ignores wikilinks inside inline code spans and indented code blocks", () => {
    // Arrange
    const visibleLine = "Visible [[Actual Page]] after `[[Ignored Inline]]` and [[Second|Alias]].";
    const content = `# Page

Use \`[[Inline Example]]\` to document syntax.
    [[Indented Example]]
\t[[Tabbed Example]]
${visibleLine}
`;

    // Act
    const links = parseWikilinks({ path: "curated/page.md", content });

    // Assert
    expect(links).toEqual([
      {
        path: "curated/page.md",
        line: 6,
        column: visibleLine.indexOf("[[Actual Page]]") + 1,
        raw: "[[Actual Page]]",
        target: "Actual Page",
        alias: null,
        embed: false,
      },
      {
        path: "curated/page.md",
        line: 6,
        column: visibleLine.indexOf("[[Second|Alias]]") + 1,
        raw: "[[Second|Alias]]",
        target: "Second",
        alias: "Alias",
        embed: false,
      },
    ]);
  });

  it("preserves wikilinks inside nested Markdown list items", () => {
    // Arrange
    const childLine = "    - [[Child Page]]";
    const grandchildLine = "        1. ![[assets/nested.png|Nested Image]]";
    const content = `# Page

- Parent
${childLine}
${grandchildLine}
`;

    // Act
    const links = parseWikilinks({ path: "curated/page.md", content });

    // Assert
    expect(links).toEqual([
      {
        path: "curated/page.md",
        line: 4,
        column: childLine.indexOf("[[Child Page]]") + 1,
        raw: "[[Child Page]]",
        target: "Child Page",
        alias: null,
        embed: false,
      },
      {
        path: "curated/page.md",
        line: 5,
        column: grandchildLine.indexOf("![[assets/nested.png|Nested Image]]") + 1,
        raw: "![[assets/nested.png|Nested Image]]",
        target: "assets/nested.png",
        alias: "Nested Image",
        embed: true,
      },
    ]);
  });

  it("preserves wikilinks inside wrapped list continuation text", () => {
    // Arrange
    const spaceContinuation = "    see [[Wrapped Page]]";
    const tabContinuation = "\tsee ![[assets/wrapped.png|Wrapped Image]]";
    const content = `# Page

- First item
${spaceContinuation}
- Second item
${tabContinuation}
Outside list.
    [[Standalone Code]]
`;

    // Act
    const links = parseWikilinks({ path: "curated/page.md", content });

    // Assert
    expect(links).toEqual([
      {
        path: "curated/page.md",
        line: 4,
        column: spaceContinuation.indexOf("[[Wrapped Page]]") + 1,
        raw: "[[Wrapped Page]]",
        target: "Wrapped Page",
        alias: null,
        embed: false,
      },
      {
        path: "curated/page.md",
        line: 6,
        column: tabContinuation.indexOf("![[assets/wrapped.png|Wrapped Image]]") + 1,
        raw: "![[assets/wrapped.png|Wrapped Image]]",
        target: "assets/wrapped.png",
        alias: "Wrapped Image",
        embed: true,
      },
    ]);
  });

  it("ignores wikilinks inside list-indented code while preserving list prose links", () => {
    // Arrange
    const listItem = "- Keep [[Visible List]]";
    const indentedCode = "      [[Demo]]";
    const continuation = "    Continue with [[Visible Continuation]]";
    const nestedList = "    - [[Visible Nested]]";
    const content = `# Page

${listItem}
${indentedCode}
${continuation}
${nestedList}
`;

    // Act
    const links = parseWikilinks({ path: "curated/page.md", content });

    // Assert
    expect(links).toEqual([
      {
        path: "curated/page.md",
        line: 3,
        column: listItem.indexOf("[[Visible List]]") + 1,
        raw: "[[Visible List]]",
        target: "Visible List",
        alias: null,
        embed: false,
      },
      {
        path: "curated/page.md",
        line: 5,
        column: continuation.indexOf("[[Visible Continuation]]") + 1,
        raw: "[[Visible Continuation]]",
        target: "Visible Continuation",
        alias: null,
        embed: false,
      },
      {
        path: "curated/page.md",
        line: 6,
        column: nestedList.indexOf("[[Visible Nested]]") + 1,
        raw: "[[Visible Nested]]",
        target: "Visible Nested",
        alias: null,
        embed: false,
      },
    ]);
  });

  it("ignores wikilinks inside fenced code blocks nested in Markdown list items", () => {
    // Arrange
    const listItem = "- Keep [[Visible Before]]";
    const continuation = "    Continue with [[Visible After]]";
    const content = `# Page

${listItem}
    \`\`\`md
    [[Demo]]
    \`\`\`
${continuation}
`;

    // Act
    const links = parseWikilinks({ path: "curated/page.md", content });

    // Assert
    expect(links).toEqual([
      {
        path: "curated/page.md",
        line: 3,
        column: listItem.indexOf("[[Visible Before]]") + 1,
        raw: "[[Visible Before]]",
        target: "Visible Before",
        alias: null,
        embed: false,
      },
      {
        path: "curated/page.md",
        line: 7,
        column: continuation.indexOf("[[Visible After]]") + 1,
        raw: "[[Visible After]]",
        target: "Visible After",
        alias: null,
        embed: false,
      },
    ]);
  });

  it("ignores wikilinks inside blockquoted fenced code while preserving blockquote prose links", () => {
    // Arrange
    const quotedBefore = "> Quote [[Visible Before]]";
    const quotedAfter = "> Quote [[Visible After]]";
    const content = `# Page

${quotedBefore}
> \`\`\`markdown
> [[Demo]]
> \`\`\`
${quotedAfter}
`;

    // Act
    const links = parseWikilinks({ path: "curated/page.md", content });

    // Assert
    expect(links).toEqual([
      {
        path: "curated/page.md",
        line: 3,
        column: quotedBefore.indexOf("[[Visible Before]]") + 1,
        raw: "[[Visible Before]]",
        target: "Visible Before",
        alias: null,
        embed: false,
      },
      {
        path: "curated/page.md",
        line: 7,
        column: quotedAfter.indexOf("[[Visible After]]") + 1,
        raw: "[[Visible After]]",
        target: "Visible After",
        alias: null,
        embed: false,
      },
    ]);
  });

  it("ignores wikilinks inside blockquoted indented code while preserving blockquote prose links", () => {
    // Arrange
    const quotedBefore = "> Quote [[Visible Before]]";
    const quotedAfter = "> Quote [[Visible After]]";
    const content = `# Page

${quotedBefore}
>     [[Demo]]
${quotedAfter}
`;

    // Act
    const links = parseWikilinks({ path: "curated/page.md", content });

    // Assert
    expect(links).toEqual([
      {
        path: "curated/page.md",
        line: 3,
        column: quotedBefore.indexOf("[[Visible Before]]") + 1,
        raw: "[[Visible Before]]",
        target: "Visible Before",
        alias: null,
        embed: false,
      },
      {
        path: "curated/page.md",
        line: 5,
        column: quotedAfter.indexOf("[[Visible After]]") + 1,
        raw: "[[Visible After]]",
        target: "Visible After",
        alias: null,
        embed: false,
      },
    ]);
  });
});
