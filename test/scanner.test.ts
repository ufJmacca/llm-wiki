import { describe, expect, it } from "vitest";

import { planWikiScaffold } from "../src/scaffold/files.js";
import {
  computeContentHash,
  parseCacheMetadata,
  parseMarkdownLinks,
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
      original_path: "raw/inputs/2026/06/src_2026_06_17_research_note_a1b2c3d4/original.md",
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
      kind: "file",
      status: "archived",
      path: "raw/inputs/2026/06/not-a-source-id/_source.md",
      original_path: "raw/inputs/2026/06/not-a-source-id/original.md",
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
      original_path: `raw/inputs/2026/99/${invalidMonthSourceId}/original.md`,
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

  it("allows closing brackets inside wikilink aliases", () => {
    // Arrange
    const content = `# Page

Links to [[Private|alias ] text]] and ![[raw/inputs/source/original.md|raw ] alias]].
`;

    // Act
    const links = parseWikilinks({ path: "curated/page.md", content });

    // Assert
    expect(links).toEqual([
      expect.objectContaining({
        path: "curated/page.md",
        line: 3,
        raw: "[[Private|alias ] text]]",
        target: "Private",
        alias: "alias ] text",
        embed: false,
      }),
      expect.objectContaining({
        path: "curated/page.md",
        line: 3,
        raw: "![[raw/inputs/source/original.md|raw ] alias]]",
        target: "raw/inputs/source/original.md",
        alias: "raw ] alias",
        embed: true,
      }),
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

describe("scanner Markdown link parsing", () => {
  it("parses inline Markdown links while ignoring code", () => {
    // Arrange
    const visibleLine = "Visible [private page](private.md) and ![raw file](../raw/original.md \"raw\").";
    const content = `# Page

\`[ignored inline](raw/secret.md)\`
    [ignored indented](raw/secret.md)
${visibleLine}

\`\`\`markdown
[ignored fenced](raw/secret.md)
\`\`\`
`;

    // Act
    const links = parseMarkdownLinks({ path: "curated/page.md", content });

    // Assert
    expect(links).toEqual([
      {
        path: "curated/page.md",
        line: 5,
        column: visibleLine.indexOf("[private page]") + 1,
        raw: "[private page](private.md)",
        text: "private page",
        target: "private.md",
        embed: false,
      },
      {
        path: "curated/page.md",
        line: 5,
        column: visibleLine.indexOf("![raw file]") + 1,
        raw: '![raw file](../raw/original.md "raw")',
        text: "raw file",
        target: "../raw/original.md",
        embed: true,
      },
    ]);
  });

  it("parses URI autolinks while ignoring code, HTML tags, and link destinations", () => {
    // Arrange
    const visibleLine = "Visible <file:///repo/raw/inputs/source/original.md> and <https://example.test/page>.";
    const content = `# Page

\`<file:///ignored/raw/original.md>\`
    <file:///ignored/raw/original.md>
${visibleLine}
[inline](<file:///repo/raw/inputs/source/inline.md>)
[raw-ref]: <file:///repo/raw/inputs/source/reference.md>
<div>not a link</div>
`;

    // Act
    const links = parseMarkdownLinks({ path: "curated/page.md", content });

    // Assert
    expect(links).toEqual([
      {
        path: "curated/page.md",
        line: 5,
        column: visibleLine.indexOf("<file:") + 1,
        raw: "<file:///repo/raw/inputs/source/original.md>",
        text: "file:///repo/raw/inputs/source/original.md",
        target: "file:///repo/raw/inputs/source/original.md",
        embed: false,
      },
      {
        path: "curated/page.md",
        line: 5,
        column: visibleLine.indexOf("<https:") + 1,
        raw: "<https://example.test/page>",
        text: "https://example.test/page",
        target: "https://example.test/page",
        embed: false,
      },
      {
        path: "curated/page.md",
        line: 6,
        column: 1,
        raw: "[inline](<file:///repo/raw/inputs/source/inline.md>)",
        text: "inline",
        target: "file:///repo/raw/inputs/source/inline.md",
        embed: false,
      },
    ]);
  });

  it("parses HTML href and src links while ignoring code and preserving Markdown link labels", () => {
    // Arrange
    const rawUrl = "file:///repo/raw/inputs/source/original.md";
    const imageUrl = "../raw/inputs/source/original.png";
    const htmlLine = `<a class="source" href="${rawUrl}">raw</a> <img alt="raw" src='${imageUrl}'>.`;
    const content = `# Page

\`<a href="${rawUrl}">ignored</a>\`
    <img src="${imageUrl}">
[inline <a href="${rawUrl}">label</a>](public.md)
${htmlLine}
`;

    // Act
    const links = parseMarkdownLinks({ path: "curated/page.md", content });

    // Assert
    expect(links).toEqual([
      {
        path: "curated/page.md",
        line: 5,
        column: 1,
        raw: `[inline <a href="${rawUrl}">label</a>](public.md)`,
        text: `inline <a href="${rawUrl}">label</a>`,
        target: "public.md",
        embed: false,
      },
      {
        path: "curated/page.md",
        line: 5,
        column: "[inline <a ".length + 1,
        raw: `href="${rawUrl}"`,
        text: "href",
        target: rawUrl,
        embed: false,
      },
      {
        path: "curated/page.md",
        line: 6,
        column: htmlLine.indexOf("href=") + 1,
        raw: `href="${rawUrl}"`,
        text: "href",
        target: rawUrl,
        embed: false,
      },
      {
        path: "curated/page.md",
        line: 6,
        column: htmlLine.indexOf("src=") + 1,
        raw: `src='${imageUrl}'`,
        text: "src",
        target: imageUrl,
        embed: true,
      },
    ]);
  });

  it("decodes HTML character references in href and src targets", () => {
    // Arrange
    const encodedRawPath = "raw&#47;inputs&#x2F;source&sol;original.md";
    const encodedImagePath = "raw&#47;inputs&#x2F;source&sol;original.png";
    const content = `# Page

<a href="${encodedRawPath}">raw</a>
<img src='${encodedImagePath}'>
`;

    // Act
    const links = parseMarkdownLinks({ path: "curated/page.md", content });

    // Assert
    expect(links).toEqual([
      {
        path: "curated/page.md",
        line: 3,
        column: 4,
        raw: `href="${encodedRawPath}"`,
        text: "href",
        target: "raw/inputs/source/original.md",
        embed: false,
      },
      {
        path: "curated/page.md",
        line: 4,
        column: 6,
        raw: `src='${encodedImagePath}'`,
        text: "src",
        target: "raw/inputs/source/original.png",
        embed: true,
      },
    ]);
  });

  it("parses HTML data-* resource attributes", () => {
    // Arrange
    const rawUrl = "file:///repo/raw/inputs/source/original.md";
    const linkUrl = "../raw/inputs/source/original.md";
    const imageUrl = "../raw/assets/source/original.png";
    const dataLine = `<div data-url="${rawUrl}" data-href='${linkUrl}' data-src=${imageUrl}></div>`;
    const srcsetLine = `<img data-srcset="safe.png 1x, ${imageUrl} 2x">`;
    const lazySrcsetLine = `<img data-lazy-srcset="https://cdn.example/safe.png 1x, ${imageUrl} 2x">`;
    const content = `# Page

${dataLine}
${srcsetLine}
${lazySrcsetLine}
`;

    // Act
    const links = parseMarkdownLinks({ path: "curated/page.md", content });

    // Assert
    expect(links).toEqual([
      {
        path: "curated/page.md",
        line: 3,
        column: dataLine.indexOf("data-url=") + 1,
        raw: `data-url="${rawUrl}"`,
        text: "data-url",
        target: rawUrl,
        embed: true,
      },
      {
        path: "curated/page.md",
        line: 3,
        column: dataLine.indexOf("data-href=") + 1,
        raw: `data-href='${linkUrl}'`,
        text: "data-href",
        target: linkUrl,
        embed: true,
      },
      {
        path: "curated/page.md",
        line: 3,
        column: dataLine.indexOf("data-src=") + 1,
        raw: `data-src=${imageUrl}`,
        text: "data-src",
        target: imageUrl,
        embed: true,
      },
      {
        path: "curated/page.md",
        line: 4,
        column: srcsetLine.indexOf("data-srcset=") + 1,
        raw: `data-srcset="safe.png 1x, ${imageUrl} 2x"`,
        text: "data-srcset",
        target: "safe.png",
        embed: true,
      },
      {
        path: "curated/page.md",
        line: 4,
        column: srcsetLine.indexOf("data-srcset=") + 1,
        raw: `data-srcset="safe.png 1x, ${imageUrl} 2x"`,
        text: "data-srcset",
        target: imageUrl,
        embed: true,
      },
      {
        path: "curated/page.md",
        line: 5,
        column: lazySrcsetLine.indexOf("data-lazy-srcset=") + 1,
        raw: `data-lazy-srcset="https://cdn.example/safe.png 1x, ${imageUrl} 2x"`,
        text: "data-lazy-srcset",
        target: "https://cdn.example/safe.png",
        embed: true,
      },
      {
        path: "curated/page.md",
        line: 5,
        column: lazySrcsetLine.indexOf("data-lazy-srcset=") + 1,
        raw: `data-lazy-srcset="https://cdn.example/safe.png 1x, ${imageUrl} 2x"`,
        text: "data-lazy-srcset",
        target: imageUrl,
        embed: true,
      },
    ]);
  });

  it("parses namespaced HTML resource attributes by local name", () => {
    // Arrange
    const rawUrl = "../raw/inputs/source/original.svg";
    const svgLine = `<svg><use xlink:href="${rawUrl}" xlink:title="../raw/ignored"></use></svg>`;
    const content = `# Page

${svgLine}
`;

    // Act
    const links = parseMarkdownLinks({ path: "curated/page.md", content });

    // Assert
    expect(links).toEqual([
      {
        path: "curated/page.md",
        line: 3,
        column: svgLine.indexOf("xlink:href=") + 1,
        raw: `xlink:href="${rawUrl}"`,
        text: "xlink:href",
        target: rawUrl,
        embed: false,
      },
    ]);
  });

  it("does not parse data-* text inside unrelated HTML attributes", () => {
    // Arrange
    const content = `# Page

<div title="example data-url=../../raw/foo" aria-label='data-src=../raw/file'></div>
`;

    // Act
    const links = parseMarkdownLinks({ path: "curated/page.md", content });

    // Assert
    expect(links).toEqual([]);
  });

  it("parses multiline HTML href and src attributes", () => {
    // Arrange
    const rawUrl = "file:///repo/raw/inputs/source/original.md";
    const imageUrl = "../raw/inputs/source/original.png";
    const content = `# Page

<a
  class="source"
  href
    =
    "${rawUrl}"
>raw</a>
<img
  alt="raw"
  src='${imageUrl}'
>

\`\`\`html
<a
  href="${rawUrl}"
>ignored</a>
\`\`\`
`;

    // Act
    const links = parseMarkdownLinks({ path: "curated/page.md", content });

    // Assert
    expect(links).toEqual([
      {
        path: "curated/page.md",
        line: 5,
        column: 3,
        raw: `href
    =
    "${rawUrl}"`,
        text: "href",
        target: rawUrl,
        embed: false,
      },
      {
        path: "curated/page.md",
        line: 11,
        column: 3,
        raw: `src='${imageUrl}'`,
        text: "src",
        target: imageUrl,
        embed: true,
      },
    ]);
  });

  it("parses inline Markdown destinations with balanced parentheses", () => {
    // Arrange
    const visibleLine = 'Visible [raw file](../raw/file(1).pdf "raw") and [plain](plain.md).';
    const content = `# Page

${visibleLine}
`;

    // Act
    const links = parseMarkdownLinks({ path: "curated/page.md", content });

    // Assert
    expect(links).toEqual([
      {
        path: "curated/page.md",
        line: 3,
        column: visibleLine.indexOf("[raw file]") + 1,
        raw: '[raw file](../raw/file(1).pdf "raw")',
        text: "raw file",
        target: "../raw/file(1).pdf",
        embed: false,
      },
      {
        path: "curated/page.md",
        line: 3,
        column: visibleLine.indexOf("[plain]") + 1,
        raw: "[plain](plain.md)",
        text: "plain",
        target: "plain.md",
        embed: false,
      },
    ]);
  });

  it("unescapes Markdown escapes in inline destinations", () => {
    // Arrange
    const visibleLine = "Visible [private](../private/foo\\).md).";
    const content = `# Page

${visibleLine}
`;

    // Act
    const links = parseMarkdownLinks({ path: "curated/page.md", content });

    // Assert
    expect(links).toEqual([
      {
        path: "curated/page.md",
        line: 3,
        column: visibleLine.indexOf("[private]") + 1,
        raw: "[private](../private/foo\\).md)",
        text: "private",
        target: "../private/foo).md",
        embed: false,
      },
    ]);
  });

  it("decodes HTML character references in inline Markdown destinations", () => {
    // Arrange
    const visibleLine =
      "Visible [raw](&period;&period;&sol;raw&#47;original&period;md) and [file](file&colon;&sol;&sol;&sol;tmp&#47;raw&#47;original.md).";
    const content = `# Page

${visibleLine}
`;

    // Act
    const links = parseMarkdownLinks({ path: "curated/page.md", content });

    // Assert
    expect(links).toEqual([
      {
        path: "curated/page.md",
        line: 3,
        column: visibleLine.indexOf("[raw]") + 1,
        raw: "[raw](&period;&period;&sol;raw&#47;original&period;md)",
        text: "raw",
        target: "../raw/original.md",
        embed: false,
      },
      {
        path: "curated/page.md",
        line: 3,
        column: visibleLine.indexOf("[file]") + 1,
        raw: "[file](file&colon;&sol;&sol;&sol;tmp&#47;raw&#47;original.md)",
        text: "file",
        target: "file:///tmp/raw/original.md",
        embed: false,
      },
    ]);
  });

  it("parses inline Markdown labels with balanced brackets", () => {
    // Arrange
    const visibleLine = "Visible [raw [PDF]](../raw/file.pdf) and [private [topic]](private.md).";
    const content = `# Page

${visibleLine}
`;

    // Act
    const links = parseMarkdownLinks({ path: "curated/page.md", content });

    // Assert
    expect(links).toEqual([
      {
        path: "curated/page.md",
        line: 3,
        column: visibleLine.indexOf("[raw [PDF]]") + 1,
        raw: "[raw [PDF]](../raw/file.pdf)",
        text: "raw [PDF]",
        target: "../raw/file.pdf",
        embed: false,
      },
      {
        path: "curated/page.md",
        line: 3,
        column: visibleLine.indexOf("[private [topic]]") + 1,
        raw: "[private [topic]](private.md)",
        text: "private [topic]",
        target: "private.md",
        embed: false,
      },
    ]);
  });

  it("parses inline Markdown labels across soft line breaks", () => {
    // Arrange
    const content = `# Page

[raw
file](../raw/original.md) and [plain](plain.md).
`;

    // Act
    const links = parseMarkdownLinks({ path: "curated/page.md", content });

    // Assert
    expect(links).toEqual([
      {
        path: "curated/page.md",
        line: 3,
        column: 1,
        raw: "[raw\nfile](../raw/original.md)",
        text: "raw\nfile",
        target: "../raw/original.md",
        embed: false,
      },
      {
        path: "curated/page.md",
        line: 4,
        column: "file](../raw/original.md) and ".length + 1,
        raw: "[plain](plain.md)",
        text: "plain",
        target: "plain.md",
        embed: false,
      },
    ]);
  });

  it("parses image links nested inside outer Markdown links", () => {
    // Arrange
    const visibleLine = "Visible [![raw](../../raw/a.png)](https://example.test/source) and [plain](plain.md).";
    const content = `# Page

${visibleLine}
`;

    // Act
    const links = parseMarkdownLinks({ path: "curated/page.md", content });

    // Assert
    expect(links).toEqual([
      {
        path: "curated/page.md",
        line: 3,
        column: visibleLine.indexOf("[![raw]") + 1,
        raw: "[![raw](../../raw/a.png)](https://example.test/source)",
        text: "![raw](../../raw/a.png)",
        target: "https://example.test/source",
        embed: false,
      },
      {
        path: "curated/page.md",
        line: 3,
        column: visibleLine.indexOf("![raw]") + 1,
        raw: "![raw](../../raw/a.png)",
        text: "raw",
        target: "../../raw/a.png",
        embed: true,
      },
      {
        path: "curated/page.md",
        line: 3,
        column: visibleLine.indexOf("[plain]") + 1,
        raw: "[plain](plain.md)",
        text: "plain",
        target: "plain.md",
        embed: false,
      },
    ]);
  });

  it("preserves reference-style images nested inside outer Markdown links", () => {
    // Arrange
    const visibleLine = "Visible [![raw][raw-ref]](https://example.test/source).";
    const content = `# Page

${visibleLine}

[raw-ref]: ../../raw/assets/secret.png
`;

    // Act
    const links = parseMarkdownLinks({ path: "curated/page.md", content });

    // Assert
    expect(links).toEqual([
      {
        path: "curated/page.md",
        line: 3,
        column: visibleLine.indexOf("[![raw]") + 1,
        raw: "[![raw][raw-ref]](https://example.test/source)",
        text: "![raw][raw-ref]",
        target: "https://example.test/source",
        embed: false,
      },
      {
        path: "curated/page.md",
        line: 3,
        column: visibleLine.indexOf("![raw]") + 1,
        raw: "![raw][raw-ref]",
        text: "raw",
        target: "../../raw/assets/secret.png",
        embed: true,
      },
    ]);
  });

  it("parses reference-style Markdown links through definitions", () => {
    // Arrange
    const visibleLine =
      "Visible [private page][p], ![raw file][raw-ref], [collapsed][], [raw [PDF]][], and [shortcut].";
    const content = `# Page

\`[ignored reference][p]\`
    [ignored indented][p]
${visibleLine}

[p]: private.md
[raw-ref]: <../raw/original.md> "raw"
[collapsed]: collapsed.md
[raw [PDF]]: ../raw/balanced.pdf
[shortcut]: shortcut.md
`;

    // Act
    const links = parseMarkdownLinks({ path: "curated/page.md", content });

    // Assert
    expect(links).toEqual([
      {
        path: "curated/page.md",
        line: 5,
        column: visibleLine.indexOf("[private page]") + 1,
        raw: "[private page][p]",
        text: "private page",
        target: "private.md",
        embed: false,
      },
      {
        path: "curated/page.md",
        line: 5,
        column: visibleLine.indexOf("![raw file]") + 1,
        raw: "![raw file][raw-ref]",
        text: "raw file",
        target: "../raw/original.md",
        embed: true,
      },
      {
        path: "curated/page.md",
        line: 5,
        column: visibleLine.indexOf("[collapsed]") + 1,
        raw: "[collapsed][]",
        text: "collapsed",
        target: "collapsed.md",
        embed: false,
      },
      {
        path: "curated/page.md",
        line: 5,
        column: visibleLine.indexOf("[raw [PDF]]") + 1,
        raw: "[raw [PDF]][]",
        text: "raw [PDF]",
        target: "../raw/balanced.pdf",
        embed: false,
      },
      {
        path: "curated/page.md",
        line: 5,
        column: visibleLine.indexOf("[shortcut]") + 1,
        raw: "[shortcut]",
        text: "shortcut",
        target: "shortcut.md",
        embed: false,
      },
    ]);
  });

  it("does not fabricate overlapping reference links after consumed labels", () => {
    // Arrange
    const visibleLine = "[One][safe][Two][also-safe]";
    const content = `# Page

${visibleLine}

[safe]: public-one.md
[also-safe]: public-two.md
[Two]: ../../raw/assets/secret.png
`;

    // Act
    const links = parseMarkdownLinks({ path: "curated/page.md", content });

    // Assert
    expect(links).toEqual([
      {
        path: "curated/page.md",
        line: 3,
        column: visibleLine.indexOf("[One]") + 1,
        raw: "[One][safe]",
        text: "One",
        target: "public-one.md",
        embed: false,
      },
      {
        path: "curated/page.md",
        line: 3,
        column: visibleLine.indexOf("[Two]") + 1,
        raw: "[Two][also-safe]",
        text: "Two",
        target: "public-two.md",
        embed: false,
      },
    ]);
  });

  it("preserves shortcut images nested inside outer reference links", () => {
    // Arrange
    const visibleLine = "[![raw]][outer]";
    const content = `# Page

${visibleLine}

[raw]: ../../raw/assets/secret.png
[outer]: https://example.test/source
`;

    // Act
    const links = parseMarkdownLinks({ path: "curated/page.md", content });

    // Assert
    expect(links).toEqual([
      {
        path: "curated/page.md",
        line: 3,
        column: 1,
        raw: "[![raw]][outer]",
        text: "![raw]",
        target: "https://example.test/source",
        embed: false,
      },
      {
        path: "curated/page.md",
        line: 3,
        column: visibleLine.indexOf("![raw]") + 1,
        raw: "![raw]",
        text: "raw",
        target: "../../raw/assets/secret.png",
        embed: true,
      },
    ]);
  });

  it("preserves shortcut images nested inside bracketed shortcut labels", () => {
    // Arrange
    const visibleLine = "[![raw]]";
    const content = `# Page

${visibleLine}

[raw]: ../../raw/assets/secret.png
`;

    // Act
    const links = parseMarkdownLinks({ path: "curated/page.md", content });

    // Assert
    expect(links).toEqual([
      {
        path: "curated/page.md",
        line: 3,
        column: visibleLine.indexOf("![raw]") + 1,
        raw: "![raw]",
        text: "raw",
        target: "../../raw/assets/secret.png",
        embed: true,
      },
    ]);
  });

  it("does not emit explicit image reference labels nested inside outer reference links as shortcuts", () => {
    // Arrange
    const visibleLine = "[![raw][raw-ref]][outer]";
    const content = `# Page

${visibleLine}

[raw-ref]: ../../raw/assets/secret.png
[outer]: https://example.test/source
`;

    // Act
    const links = parseMarkdownLinks({ path: "curated/page.md", content });

    // Assert
    expect(links).toEqual([
      {
        path: "curated/page.md",
        line: 3,
        column: 1,
        raw: "[![raw][raw-ref]][outer]",
        text: "![raw][raw-ref]",
        target: "https://example.test/source",
        embed: false,
      },
      {
        path: "curated/page.md",
        line: 3,
        column: visibleLine.indexOf("![raw]") + 1,
        raw: "![raw][raw-ref]",
        text: "raw",
        target: "../../raw/assets/secret.png",
        embed: true,
      },
    ]);
  });

  it("parses reference-style Markdown links through blockquoted definitions", () => {
    // Arrange
    const visibleLine = "> Visible [raw file][raw-ref].";
    const content = `# Page

${visibleLine}
> [raw-ref]: <../raw/original.md> "raw"
`;

    // Act
    const links = parseMarkdownLinks({ path: "curated/page.md", content });

    // Assert
    expect(links).toEqual([
      {
        path: "curated/page.md",
        line: 3,
        column: visibleLine.indexOf("[raw file]") + 1,
        raw: "[raw file][raw-ref]",
        text: "raw file",
        target: "../raw/original.md",
        embed: false,
      },
    ]);
  });

  it("does not treat Obsidian footnotes as reference-style Markdown links", () => {
    // Arrange
    const content = `# Page

Footnote marker[^1].

[^1]: raw notes from a local source.
`;

    // Act
    const links = parseMarkdownLinks({ path: "curated/page.md", content });

    // Assert
    expect(links).toEqual([]);
  });
});
